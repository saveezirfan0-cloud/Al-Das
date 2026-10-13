import "server-only";

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import {
  bumpUsage,
  dbBreakerStore,
  dbCallSink,
  loadAccount,
  readConfig,
  readSecrets,
  recordFailure,
  recordOk,
  type AccountRow,
} from "@/lib/integrations/accounts";
import { readTelehealthConfig } from "@/lib/integrations/telehealth/config";
import { createDailyProvider } from "@/lib/integrations/telehealth/daily";
import {
  effectiveVisitMode,
  linkAllowedFor,
  roomIsCurrent,
  roomWindow,
  videoLinkValue,
  type VisitMode,
} from "@/lib/integrations/telehealth/policy";
import { createStaticProvider } from "@/lib/integrations/telehealth/static";
import { hashRoomToken, newRoomToken } from "@/lib/integrations/telehealth/token";
import type { TelehealthProvider } from "@/lib/integrations/telehealth/types";
import { buildRoomUrl } from "@/lib/integrations/telehealth/url";
import { scheduleJob } from "@/lib/jobs/enqueue";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";
import { isTrainingOrg } from "@/lib/training/mode";

/**
 * Video rooms for video appointments, server side.
 *
 * A room is created the first time it is needed (a member of staff presses Join, or a message that carries the video link is rendered),
 * with an unguessable 256-bit token. Only the token's SHA-256 and an AES-256-GCM copy are stored. The room is valid until the booked end
 * plus a grace period, is replaced when the booked time changes and is revoked when the visit is cancelled, missed or completed.
 * Nothing about the patient reaches the provider: the room name is the token and the only other things sent are two timestamps.
 */

export type RoomFailure =
  | "off"
  | "training"
  | "not_video"
  | "no_appointment"
  | "inactive"
  | "expired"
  | "not_configured"
  | "busy"
  | "provider_error";

export type EnsureRoomResult =
  | { ok: true; url: string; expiresAt: string; created: boolean }
  | { ok: false; reason: RoomFailure };

export const ROOM_FAILURE_TEXT: Record<RoomFailure, string> = {
  off: "Video visits are switched off. An administrator can turn them on in Settings, Integrations.",
  training: "This is a training workspace: video links are not created here.",
  not_video: "This is not a video appointment.",
  no_appointment: "Appointment not found.",
  inactive: "This appointment is cancelled, missed or not open, so it has no video link.",
  expired: "The video link for this appointment has expired.",
  not_configured: "The video provider settings are incomplete.",
  busy: "The link is being prepared. Try again in a moment.",
  provider_error: "The video provider could not create the room. Try again in a moment.",
};

/** The configured provider with call logging and the stored breaker, or null while settings are incomplete. */
export function buildTelehealthProvider(
  admin: AdminClient,
  account: AccountRow,
): TelehealthProvider | null {
  const cfg = readTelehealthConfig(readConfig(account));
  if (cfg.provider === "static") return createStaticProvider(cfg.urlTemplate);
  const secrets = readSecrets(account);
  return createDailyProvider({
    apiKey: secrets.api_key ?? "",
    domain: cfg.dailyDomain,
    sink: dbCallSink(admin, account.org_id),
    breaker: dbBreakerStore(admin, account.org_id, "telehealth"),
  });
}

type ApptFacts = {
  id: string;
  status: string;
  starts_at: string;
  ends_at: string;
  visit_mode: string | null;
  services: { default_visit_mode: string | null } | null;
};

async function loadAppt(admin: AdminClient, orgId: string, id: string): Promise<ApptFacts | null> {
  const { data } = await admin
    .from("appointments")
    .select("id, status, starts_at, ends_at, visit_mode, services(default_visit_mode)")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  return data as ApptFacts | null;
}

export async function loadVisitMode(
  admin: AdminClient,
  orgId: string,
  appointmentId: string,
): Promise<VisitMode | null> {
  const a = await loadAppt(admin, orgId, appointmentId);
  return a ? effectiveVisitMode(a.visit_mode, a.services?.default_visit_mode) : null;
}

/** The address of a stored room (decrypted token + the configured template or domain). */
function roomUrl(
  cfg: ReturnType<typeof readTelehealthConfig>,
  room: { token_enc: string },
): string | null {
  try {
    const token = decryptSecret(room.token_enc);
    return cfg.provider === "daily"
      ? `https://${cfg.dailyDomain}.daily.co/${token}`
      : buildRoomUrl(cfg.urlTemplate, token);
  } catch {
    return null;
  }
}

/**
 * Revokes the live room(s) of an appointment. The provider's copy (if it has one) is deleted by a durable job so a cancellation never
 * waits on, or fails because of, the provider.
 */
export async function revokeRooms(
  admin: AdminClient,
  a: { orgId: string; appointmentId: string; reason: string },
): Promise<number> {
  const { data: rooms } = await admin
    .from("telehealth_rooms")
    .update({
      status: "revoked",
      revoked_reason: a.reason.slice(0, 40),
      revoked_at: new Date().toISOString(),
    })
    .eq("org_id", a.orgId)
    .eq("appointment_id", a.appointmentId)
    .in("status", ["creating", "active"])
    .select("id, provider, room_ref");
  for (const r of rooms ?? []) {
    if (r.provider === "static" || !r.room_ref) continue;
    try {
      await scheduleJob({
        kind: "telehealth.cleanup",
        orgId: a.orgId,
        runAt: new Date(),
        payload: { room_id: r.id },
        dedupeKey: `telehealth-cleanup:${r.id}`,
      });
    } catch (err) {
      console.error("[telehealth] could not schedule a room clean-up", {
        error: redactText(err, 120),
      });
    }
  }
  return rooms?.length ?? 0;
}

/** Hook wrapper: a cancellation or reschedule must never fail because a room could not be revoked. */
export async function revokeRoomsSafely(
  admin: AdminClient,
  a: { orgId: string; appointmentId: string; reason: string },
): Promise<void> {
  try {
    await revokeRooms(admin, a);
  } catch (err) {
    console.error("[telehealth] could not revoke a room", { error: redactText(err, 120) });
  }
}

/** The room of a video appointment: the live one if it is still right, otherwise a new one. Idempotent and safe to call concurrently. */
export async function ensureRoom(
  admin: AdminClient,
  a: {
    orgId: string;
    appointmentId: string;
    actorId?: string | null;
    now?: Date;
    provider?: TelehealthProvider;
    /** Replace the live room even if it is current (the old link was shared by mistake). */
    forceNew?: boolean;
  },
): Promise<EnsureRoomResult> {
  const now = a.now ?? new Date();
  const account = await loadAccount(admin, a.orgId, "telehealth");
  if (!account?.enabled) return { ok: false, reason: "off" };
  if (await isTrainingOrg(admin, a.orgId)) {
    await bumpUsage(admin, a.orgId, "telehealth", "blocked_training");
    return { ok: false, reason: "training" };
  }
  const appt = await loadAppt(admin, a.orgId, a.appointmentId);
  if (!appt) return { ok: false, reason: "no_appointment" };
  if (effectiveVisitMode(appt.visit_mode, appt.services?.default_visit_mode) !== "video")
    return { ok: false, reason: "not_video" };
  if (!linkAllowedFor(appt.status)) return { ok: false, reason: "inactive" };
  const cfg = readTelehealthConfig(readConfig(account));
  const win = roomWindow(new Date(appt.starts_at), new Date(appt.ends_at), cfg);
  if (win.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  const provider = a.provider ?? buildTelehealthProvider(admin, account);
  if (!provider) return { ok: false, reason: "not_configured" };

  // A room still being created by a worker that then died is closed after two minutes.
  await admin
    .from("telehealth_rooms")
    .update({ status: "revoked", revoked_reason: "stalled", revoked_at: now.toISOString() })
    .eq("org_id", a.orgId)
    .eq("appointment_id", appt.id)
    .eq("status", "creating")
    .lt("created_at", new Date(now.getTime() - 120_000).toISOString());

  const { data: live } = await admin
    .from("telehealth_rooms")
    .select("id, status, token_enc, for_starts_at, for_ends_at, expires_at")
    .eq("org_id", a.orgId)
    .eq("appointment_id", appt.id)
    .in("status", ["creating", "active"])
    .maybeSingle();
  if (live) {
    if (live.status === "creating") return { ok: false, reason: "busy" };
    if (!a.forceNew && roomIsCurrent(live, appt, now)) {
      const url = roomUrl(cfg, live);
      if (url) return { ok: true, url, expiresAt: live.expires_at, created: false };
    }
    await revokeRooms(admin, {
      orgId: a.orgId,
      appointmentId: appt.id,
      reason: a.forceNew ? "replaced" : "rescheduled",
    });
  }

  const token = newRoomToken();
  const { data: row, error } = await admin
    .from("telehealth_rooms")
    .insert({
      org_id: a.orgId,
      appointment_id: appt.id,
      provider: cfg.provider,
      token_hash: hashRoomToken(token),
      token_enc: encryptSecret(token),
      status: "creating",
      for_starts_at: appt.starts_at,
      for_ends_at: appt.ends_at,
      expires_at: win.expiresAt.toISOString(),
      created_by: a.actorId ?? null,
    })
    .select("id")
    .single();
  if (error || !row) {
    // The one-live-room index: someone else is creating it at this moment.
    return { ok: false, reason: error?.code === "23505" ? "busy" : "provider_error" };
  }
  const created = await provider.createRoom({
    roomName: token,
    expiresAt: win.expiresAt,
    notBefore: win.notBefore,
  });
  if (!created.ok) {
    await admin
      .from("telehealth_rooms")
      .update({
        status: "revoked",
        revoked_reason: "provider_error",
        revoked_at: now.toISOString(),
      })
      .eq("id", row.id);
    await recordFailure(admin, a.orgId, "telehealth", `video provider error ${created.code}`);
    await bumpUsage(admin, a.orgId, "telehealth", "create_failed");
    return { ok: false, reason: "provider_error" };
  }
  await admin
    .from("telehealth_rooms")
    .update({ status: "active", room_ref: created.roomRef })
    .eq("id", row.id);
  await recordOk(admin, a.orgId, "telehealth");
  await bumpUsage(admin, a.orgId, "telehealth", "rooms_created");
  return { ok: true, url: created.url, expiresAt: win.expiresAt.toISOString(), created: true };
}

/**
 * What a message about this appointment should say for `{{appointment.video_link}}`: the visit's mode and, for a video visit with a
 * working room, its address. Never throws: any failure gives the "your clinic will send you the video link" wording.
 */
export async function resolveVideoLink(
  admin: AdminClient,
  a: { orgId: string; appointmentId: string; now?: Date; provider?: TelehealthProvider },
): Promise<{ mode: VisitMode; url: string | null; text: string }> {
  try {
    const mode = (await loadVisitMode(admin, a.orgId, a.appointmentId)) ?? "in_person";
    if (mode !== "video") return { mode, url: null, text: videoLinkValue(mode, null) };
    const r = await ensureRoom(admin, a);
    const url = r.ok ? r.url : null;
    return { mode, url, text: videoLinkValue(mode, url) };
  } catch (err) {
    console.error("[telehealth] could not resolve a video link", { error: redactText(err, 120) });
    return { mode: "video", url: null, text: videoLinkValue("video", null) };
  }
}

/** The durable clean-up job: removes a revoked room at the provider. Throws when the provider could not be reached, so the job retries. */
export async function cleanupRoom(
  admin: AdminClient,
  a: { orgId: string; roomId: string; provider?: TelehealthProvider },
): Promise<"deleted" | "nothing_to_do" | "not_configured"> {
  const { data: room } = await admin
    .from("telehealth_rooms")
    .select("id, provider, room_ref, status, provider_deleted_at")
    .eq("id", a.roomId)
    .eq("org_id", a.orgId)
    .maybeSingle();
  if (!room || room.status !== "revoked" || room.provider_deleted_at || !room.room_ref)
    return "nothing_to_do";
  const account = await loadAccount(admin, a.orgId, "telehealth");
  const provider = a.provider ?? (account ? buildTelehealthProvider(admin, account) : null);
  if (!provider || provider.id === "static") return "not_configured";
  const ok = await provider.deleteRoom(room.room_ref);
  if (!ok) throw new Error("video provider could not delete the room; will retry");
  await admin
    .from("telehealth_rooms")
    .update({ provider_deleted_at: new Date().toISOString() })
    .eq("id", room.id);
  return "deleted";
}
