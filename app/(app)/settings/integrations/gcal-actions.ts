"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { serverEnv } from "@/lib/env";
import { gcalRedirectUri } from "@/lib/integrations/gcal/config";
import { disconnect, startConnect } from "@/lib/integrations/gcal/server";
import { checkRateLimit, waitText } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export type GcalActionResult =
  { ok: true; message: string; url?: string } | { ok: false; error: string };

const schema = z.object({ specialistId: z.string().uuid() });
const MANAGE_RULE = { limit: 20, windowSec: 60, failOpen: false } as const;

/**
 * Starts connecting a doctor's Google Calendar: returns Google's consent address (the browser goes there and Google sends it back to
 * /api/integrations/google-calendar/callback). The person who starts must also finish, within 10 minutes.
 */
export async function startGoogleCalendarConnect(
  input: z.input<typeof schema>,
): Promise<GcalActionResult> {
  const member = await requirePerm("integrations.calendar");
  const p = schema.safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid request." };
  const admin = createAdminClient(member.userId);
  const limit = await checkRateLimit(admin, "gcal-manage", member.userId, MANAGE_RULE);
  if (!limit.allowed)
    return { ok: false, error: `Too many changes. Try again in ${waitText(limit.retryAfter)}.` };
  const r = await startConnect(admin, {
    orgId: member.orgId,
    specialistId: p.data.specialistId,
    userId: member.userId,
    redirectUri: gcalRedirectUri(serverEnv().APP_URL),
  });
  if (!r.ok) return r;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "integration.google_calendar_connect_started",
    entity: "specialist",
    entityId: p.data.specialistId,
  });
  return { ok: true, message: "Opening Google…", url: r.url };
}

/** Disconnects a doctor's calendar: removes Pulse's future "Busy" events, revokes access at Google and clears the busy times. */
export async function disconnectGoogleCalendar(
  input: z.input<typeof schema>,
): Promise<GcalActionResult> {
  const member = await requirePerm("integrations.calendar");
  const p = schema.safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid request." };
  const admin = createAdminClient(member.userId);
  const limit = await checkRateLimit(admin, "gcal-manage", member.userId, MANAGE_RULE);
  if (!limit.allowed)
    return { ok: false, error: `Too many changes. Try again in ${waitText(limit.retryAfter)}.` };
  const r = await disconnect(admin, { orgId: member.orgId, specialistId: p.data.specialistId });
  if (!r.ok) return r;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "integration.google_calendar_disconnected",
    entity: "specialist",
    entityId: p.data.specialistId,
    diff: { removed_events: r.removedEvents },
  });
  revalidatePath("/settings/integrations/google_calendar");
  return { ok: true, message: "Disconnected. Pulse no longer reads or writes this calendar." };
}
