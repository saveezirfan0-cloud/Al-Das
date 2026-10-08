"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getCurrentMember, ORG_COOKIE } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export async function setPresence(presence: "online" | "away" | "offline") {
  const member = await getCurrentMember();
  if (!member) return;
  const supabase = await createClient();
  await supabase.rpc("set_presence", { p_org_id: member.orgId, p_presence: presence });
}

export async function markAllNotificationsRead() {
  const member = await getCurrentMember();
  if (!member) return;
  const supabase = await createClient();
  await supabase.rpc("mark_all_notifications_read", { p_org_id: member.orgId });
}

export async function markNotificationRead(id: string) {
  const member = await getCurrentMember();
  if (!member) return;
  const supabase = await createClient();
  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .is("read_at", null);
}

export async function switchOrg(orgId: string) {
  const member = await getCurrentMember();
  if (!member || !member.orgs.some((o) => o.id === orgId)) return;
  const cookieStore = await cookies();
  cookieStore.set(ORG_COOKIE, orgId, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  redirect("/dashboard");
}
