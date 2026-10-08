import { NextResponse, type NextRequest } from "next/server";

import { getCurrentMember } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const member = await getCurrentMember();
  if (member) await supabase.rpc("set_presence", { p_org_id: member.orgId, p_presence: "offline" });
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
