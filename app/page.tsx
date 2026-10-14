import { redirect } from "next/navigation";

import { requireMember } from "@/lib/auth/session";
import { landingPathFor } from "@/lib/front-desk/landing";

/** Signed-in people land on the page that suits their role: the Receptionist on the Front desk, the Doctor on My day, others on the dashboard. */
export default async function Home() {
  const member = await requireMember();
  redirect(landingPathFor(member));
}
