import "server-only";

import { createHash } from "node:crypto";

import { isEnabled } from "@/lib/integrations/accounts";
import { feedWindow, renderCalendar, type IcsAppointment } from "@/lib/integrations/calendar/ics";
import {
  generateFeedToken,
  hashFeedToken,
  parseFeedToken,
} from "@/lib/integrations/calendar/token";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/types";

/** Calendar feed storage and rendering. The browser never sees a token hash or an old token; the URL is returned once. */

export type FeedRow = Tables<"calendar_feeds">;
const MAX_EVENTS = 3000;

export type FeedListItem = Pick<
  FeedRow,
  | "id"
  | "kind"
  | "label"
  | "created_at"
  | "rotated_at"
  | "revoked_at"
  | "last_access_at"
  | "access_count"
  | "specialist_id"
  | "user_id"
> & { specialistName: string | null; userName: string | null };

export async function listFeeds(admin: AdminClient, orgId: string): Promise<FeedListItem[]> {
  const { data } = await admin
    .from("calendar_feeds")
    .select(
      "id, kind, label, created_at, rotated_at, revoked_at, last_access_at, access_count, specialist_id, user_id, specialists(name), profiles:user_id(first_name, last_name)",
    )
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(200);
  return (data ?? []).map((r) => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    created_at: r.created_at,
    rotated_at: r.rotated_at,
    revoked_at: r.revoked_at,
    last_access_at: r.last_access_at,
    access_count: r.access_count,
    specialist_id: r.specialist_id,
    user_id: r.user_id,
    specialistName: r.specialists?.name ?? null,
    userName: r.profiles
      ? [r.profiles.first_name, r.profiles.last_name].filter(Boolean).join(" ") || null
      : null,
  }));
}

export type CreateFeedInput = {
  orgId: string;
  actorId: string;
  target: { kind: "specialist"; specialistId: string } | { kind: "user"; userId: string };
  label: string;
};

export type FeedCreated = { ok: true; id: string; token: string } | { ok: false; error: string };

export async function createFeed(admin: AdminClient, input: CreateFeedInput): Promise<FeedCreated> {
  const label = input.label.trim().slice(0, 80);
  if (!label) return { ok: false, error: "Give the feed a name." };
  if (input.target.kind === "specialist") {
    const { data: sp } = await admin
      .from("specialists")
      .select("id")
      .eq("id", input.target.specialistId)
      .eq("org_id", input.orgId)
      .maybeSingle();
    if (!sp) return { ok: false, error: "Choose a doctor from this clinic." };
  } else {
    const { data: m } = await admin
      .from("memberships")
      .select("user_id")
      .eq("org_id", input.orgId)
      .eq("user_id", input.target.userId)
      .eq("status", "active")
      .maybeSingle();
    if (!m) return { ok: false, error: "That person is not an active member." };
  }
  const token = generateFeedToken();
  const { data, error } = await admin
    .from("calendar_feeds")
    .insert({
      org_id: input.orgId,
      kind: input.target.kind,
      specialist_id: input.target.kind === "specialist" ? input.target.specialistId : null,
      user_id: input.target.kind === "user" ? input.target.userId : null,
      label,
      token_hash: hashFeedToken(token),
      created_by: input.actorId,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: "Could not create the feed." };
  return { ok: true, id: data.id, token };
}

/** Replaces the token (the old link stops working at once) and re-opens a revoked feed. Returns the new token once. */
export async function rotateFeed(
  admin: AdminClient,
  orgId: string,
  id: string,
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const token = generateFeedToken();
  const { data, error } = await admin
    .from("calendar_feeds")
    .update({
      token_hash: hashFeedToken(token),
      rotated_at: new Date().toISOString(),
      revoked_at: null,
    })
    .eq("id", id)
    .eq("org_id", orgId)
    .select("id");
  if (error || !data?.length) return { ok: false, error: "Feed not found." };
  return { ok: true, token };
}

export async function revokeFeed(
  admin: AdminClient,
  orgId: string,
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await admin
    .from("calendar_feeds")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", orgId)
    .is("revoked_at", null)
    .select("id");
  if (error) return { ok: false, error: "Could not revoke the feed." };
  if (!data?.length) return { ok: false, error: "Feed not found or already revoked." };
  return { ok: true };
}

/** The live feed behind a URL segment, or null (unknown, revoked, malformed or integration off: one indistinguishable answer). */
export async function resolveFeed(admin: AdminClient, segment: string): Promise<FeedRow | null> {
  const token = parseFeedToken(segment);
  if (!token) return null;
  const { data } = await admin
    .from("calendar_feeds")
    .select("*")
    .eq("token_hash", hashFeedToken(token))
    .is("revoked_at", null)
    .maybeSingle();
  if (!data) return null;
  if (!(await isEnabled(admin, data.org_id, "calendar_ics"))) return null;
  return data;
}

/** The appointments a feed shows: its doctor (or every doctor profile linked to its user), last 7 days to next 60. */
export async function feedAppointments(
  admin: AdminClient,
  feed: FeedRow,
  now: Date,
): Promise<IcsAppointment[]> {
  let specialistIds: string[] = [];
  if (feed.kind === "specialist" && feed.specialist_id) specialistIds = [feed.specialist_id];
  else if (feed.kind === "user" && feed.user_id) {
    const { data } = await admin
      .from("specialists")
      .select("id")
      .eq("org_id", feed.org_id)
      .eq("user_id", feed.user_id);
    specialistIds = (data ?? []).map((s) => s.id);
  }
  if (specialistIds.length === 0) return [];
  const { from, to } = feedWindow(now);
  const { data } = await admin
    .from("appointments")
    .select("id, starts_at, ends_at, status, updated_at, locations(name)")
    .eq("org_id", feed.org_id)
    .in("specialist_id", specialistIds)
    .gte("starts_at", from.toISOString())
    .lte("starts_at", to.toISOString())
    .order("starts_at", { ascending: true })
    .limit(MAX_EVENTS);
  return (data ?? []).map((a) => ({
    id: a.id,
    startsAt: a.starts_at,
    endsAt: a.ends_at,
    status: a.status,
    updatedAt: a.updated_at,
    locationName: a.locations?.name ?? null,
  }));
}

export type ServedFeed =
  { status: 404 } | { status: 304; etag: string } | { status: 200; body: string; etag: string };

export function etagOf(body: string): string {
  return `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
}

/** Looks a feed up, renders it and counts the access (an aggregate counter; no per-request record). */
export async function serveFeed(
  admin: AdminClient,
  segment: string,
  opts: { now?: Date; ifNoneMatch?: string | null } = {},
): Promise<ServedFeed> {
  const feed = await resolveFeed(admin, segment);
  if (!feed) return { status: 404 };
  const now = opts.now ?? new Date();
  const body = renderCalendar({
    name: feed.label,
    appointments: await feedAppointments(admin, feed, now),
  });
  const etag = etagOf(body);
  await admin.rpc("calendar_feed_touch", { p_id: feed.id });
  await admin.rpc("integration_usage_bump", {
    p_org: feed.org_id,
    p_provider: "calendar_ics",
    p_metric: "feed_fetches",
    p_n: 1,
  });
  if (
    opts.ifNoneMatch &&
    opts.ifNoneMatch
      .split(",")
      .map((s) => s.trim())
      .includes(etag)
  )
    return { status: 304, etag };
  return { status: 200, body, etag };
}
