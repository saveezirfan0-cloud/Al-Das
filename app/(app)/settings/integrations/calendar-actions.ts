"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { serverEnv } from "@/lib/env";
import { isEnabled } from "@/lib/integrations/accounts";
import { createFeed, revokeFeed, rotateFeed } from "@/lib/integrations/calendar/feed-server";
import { feedUrl } from "@/lib/integrations/calendar/token";
import { checkRateLimit, RATE_RULES, waitText } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export type FeedActionResult =
  { ok: true; message: string; url?: string } | { ok: false; error: string };

const createSchema = z.object({
  label: z.string().trim().min(1).max(80),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("specialist"), specialistId: z.string().uuid() }),
    z.object({ kind: z.literal("user"), userId: z.string().uuid() }),
  ]),
});

async function limited(
  userId: string,
  admin: ReturnType<typeof createAdminClient>,
): Promise<string | null> {
  const r = await checkRateLimit(
    admin,
    "calendar-feed-manage",
    userId,
    RATE_RULES.calendarFeedManagePerUser,
  );
  return r.allowed ? null : `Too many changes. Try again in ${waitText(r.retryAfter)}.`;
}

/** Creates a feed. The URL is returned ONCE: only its hash is stored, so it cannot be shown again (rotate to get a new one). */
export async function createCalendarFeed(
  input: z.input<typeof createSchema>,
): Promise<FeedActionResult> {
  const member = await requirePerm("integrations.calendar");
  const p = createSchema.safeParse(input);
  if (!p.success)
    return { ok: false, error: "Give the feed a name and choose a doctor or person." };
  // A "my appointments" feed is for the person creating it, unless the member is an administrator.
  if (
    p.data.target.kind === "user" &&
    p.data.target.userId !== member.userId &&
    !member.permissions.includes("*") &&
    !member.permissions.includes("integrations.manage")
  )
    return { ok: false, error: "You can only create a feed for yourself." };
  const admin = createAdminClient(member.userId);
  const wait = await limited(member.userId, admin);
  if (wait) return { ok: false, error: wait };
  if (!(await isEnabled(admin, member.orgId, "calendar_ics")))
    return {
      ok: false,
      error:
        "Calendar feeds are switched off. An administrator can turn them on in Settings, Integrations.",
    };
  const created = await createFeed(admin, {
    orgId: member.orgId,
    actorId: member.userId,
    target: p.data.target,
    label: p.data.label,
  });
  if (!created.ok) return created;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "integration.calendar_feed_created",
    entity: "calendar_feed",
    entityId: created.id,
    diff: { kind: p.data.target.kind },
  });
  revalidatePath("/settings/integrations/calendar_ics");
  return {
    ok: true,
    message: "Feed created. Copy the link now: it will not be shown again.",
    url: feedUrl(serverEnv().APP_URL, created.token),
  };
}

const idSchema = z.object({ id: z.string().uuid() });

/** Replaces the link: the old one stops working at once. Returns the new URL once. */
export async function rotateCalendarFeed(
  input: z.input<typeof idSchema>,
): Promise<FeedActionResult> {
  const member = await requirePerm("integrations.calendar");
  const p = idSchema.safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid request." };
  const admin = createAdminClient(member.userId);
  const wait = await limited(member.userId, admin);
  if (wait) return { ok: false, error: wait };
  if (!(await isEnabled(admin, member.orgId, "calendar_ics")))
    return { ok: false, error: "Calendar feeds are switched off." };
  const r = await rotateFeed(admin, member.orgId, p.data.id);
  if (!r.ok) return r;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "integration.calendar_feed_rotated",
    entity: "calendar_feed",
    entityId: p.data.id,
  });
  revalidatePath("/settings/integrations/calendar_ics");
  return {
    ok: true,
    message: "New link created. The old link no longer works.",
    url: feedUrl(serverEnv().APP_URL, r.token),
  };
}

/** Stops a feed for good (rotate it to bring it back with a new link). */
export async function revokeCalendarFeed(
  input: z.input<typeof idSchema>,
): Promise<FeedActionResult> {
  const member = await requirePerm("integrations.calendar");
  const p = idSchema.safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid request." };
  const admin = createAdminClient(member.userId);
  const wait = await limited(member.userId, admin);
  if (wait) return { ok: false, error: wait };
  const r = await revokeFeed(admin, member.orgId, p.data.id);
  if (!r.ok) return r;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "integration.calendar_feed_revoked",
    entity: "calendar_feed",
    entityId: p.data.id,
  });
  revalidatePath("/settings/integrations/calendar_ics");
  return { ok: true, message: "Feed revoked." };
}
