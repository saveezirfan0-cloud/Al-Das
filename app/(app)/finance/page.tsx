import { redirect } from "next/navigation";

import { enforceFinanceWindow, requireMember } from "@/lib/auth/session";
import { financeLanding } from "@/lib/finance/nav";

export default async function FinanceIndex() {
  const member = await requireMember();
  await enforceFinanceWindow(member); // outside the finance access window: the explanation page, not the dashboard
  redirect(financeLanding(member) ?? "/dashboard");
}
