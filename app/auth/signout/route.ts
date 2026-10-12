import { NextResponse, type NextRequest } from "next/server";

import { getCurrentMember } from "@/lib/auth/session";
import { recordAuthEvent } from "@/lib/security/auth-events";
import { endSessionRows } from "@/lib/security/sessions";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const member = await getCurrentMember();
  if (member) {
    await supabase.rpc("set_presence", { p_org_id: member.orgId, p_presence: "offline" });
    const admin = createAdminClient();
    await recordAuthEvent(admin, {
      type: "sign_out",
      userId: member.userId,
      orgId: member.orgId,
      headers: request.headers,
    });
    await endSessionRows(admin, supabase, member, "this_device");
  }
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
