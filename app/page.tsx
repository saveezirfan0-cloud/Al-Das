import { redirect } from "next/navigation";

import { requireMember } from "@/lib/auth/session";
import { landingPathFor } from "@/lib/shell/landing";

/** Signed-in people land on the page that suits their role (lib/shell/landing.ts, docs/34 §3 "Home"). */
export default async function Home() {
  const member = await requireMember();
  redirect(landingPathFor(member));
}
