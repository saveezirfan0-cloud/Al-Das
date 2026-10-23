import { redirect } from "next/navigation";

import { requireMember } from "@/lib/auth/session";
import { linkIsHidden } from "@/lib/nav/menu-visibility";
import { DEFAULT_LANDING_PATH, landingPathFor } from "@/lib/shell/landing";

/**
 * Signed-in people land on the page that suits their role (lib/shell/landing.ts, docs/34 §3 "Home"), or the dashboard
 * when that page is hidden from their menu (Settings, Menu or their Menu access).
 */
export default async function Home() {
  const member = await requireMember();
  const landing = landingPathFor(member);
  redirect(linkIsHidden(landing, member.menuHidden) ? DEFAULT_LANDING_PATH : landing);
}
