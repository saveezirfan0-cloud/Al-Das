"use server";

import { z } from "zod";

import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

/** Patient 360, non-clinical lazy tabs: campaigns received. Own client (RLS), campaigns.view. */

export type CampaignRow = {
  id: string;
  campaignId: string;
  name: string;
  status: string;
  sentAt: string | null;
  replied: boolean;
};

export async function listContactCampaigns(
  contactId: string,
): Promise<{ ok: true; data: CampaignRow[] } | { ok: false; error: string }> {
  const member = await requirePerm("contacts.view");
  if (!can(member, "campaigns.view"))
    return { ok: false, error: "You don't have access to campaigns." };
  if (!z.string().uuid().safeParse(contactId).success)
    return { ok: false, error: "Invalid contact." };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("campaign_recipients")
    .select("id, campaign_id, status, sent_at, replied_at, campaigns(name)")
    .eq("org_id", member.orgId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return { ok: false, error: "Could not load the campaigns." };
  return {
    ok: true,
    data: (data ?? []).map((r) => ({
      id: r.id,
      campaignId: r.campaign_id,
      name: r.campaigns?.name ?? "Deleted campaign",
      status: r.status,
      sentAt: r.sent_at,
      replied: !!r.replied_at,
    })),
  };
}

/** The Overview card "Campaigns in the last 90 days": messages actually sent, a count only. Own client (RLS), campaigns.view. */
const RECENT_CAMPAIGN_DAYS = 90;

export async function countRecentCampaigns(
  contactId: string,
): Promise<{ ok: true; data: { count: number; days: number } } | { ok: false; error: string }> {
  const member = await requirePerm("contacts.view");
  if (!can(member, "campaigns.view"))
    return { ok: false, error: "You don't have access to campaigns." };
  if (!z.string().uuid().safeParse(contactId).success)
    return { ok: false, error: "Invalid contact." };
  const since = new Date(Date.now() - RECENT_CAMPAIGN_DAYS * 86_400_000).toISOString();
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("org_id", member.orgId)
    .eq("contact_id", contactId)
    .not("sent_at", "is", null)
    .gte("sent_at", since);
  if (error) return { ok: false, error: "Could not count the campaigns." };
  return { ok: true, data: { count: count ?? 0, days: RECENT_CAMPAIGN_DAYS } };
}
